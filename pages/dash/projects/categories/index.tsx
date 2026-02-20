import { CategoriesPage } from '@/components/categories/page';

const Categories = () => {
  return <CategoriesPage />;
};

export default Categories;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects/categories',
      title: {
        template: 'تصنيفات المشاريع',
      },
    },
  };
}
