import { SectionsPage } from '@/components/sections/page';

const Sections = () => {
  return <SectionsPage />;
};

export default Sections;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/sections',
      title: {
        template: 'الأقسام',
      },
    },
  };
}
