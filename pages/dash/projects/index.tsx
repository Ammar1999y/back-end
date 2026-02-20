import { ProjectsPage } from '@/components/projects/page';

const Projects = () => {
  return <ProjectsPage />;
};

export default Projects;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects',
      title: {
        template: 'المشاريع',
      },
    },
  };
}
